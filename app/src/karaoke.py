"""Karaokê: toca o instrumental, passa o microfone pelos plugins VST3 do usuário (Auto-Tune, reverb…) e grava.

Roda no sep-env (pedalboard + sounddevice). Nada é processado na placa de vídeo.

Listar os aparelhos de som:
    python karaoke.py --listar   -> "APARELHOS {json}" igual ao aovivo.py

Ligar:
    python karaoke.py
    Comandos: uma linha JSON por vez na entrada padrão. Quando a entrada fecha (o app sumiu), desliga.
      {"cmd": "aparelhos", "entrada": 3, "saida": 7}
      {"cmd": "musica", "instrumental": "a.wav", "guia": "voz.wav"}
      {"cmd": "tocar"} {"cmd": "pausar"} {"cmd": "ir", "s": 12.5}
      {"cmd": "volumes", "instrumental": 1, "voz": 1, "guia": 0}  {"cmd": "ouvir", "ligado": true}
      {"cmd": "gravar", "pasta": "...", "nome": "Título"}  {"cmd": "parar_gravacao"}
      {"cmd": "efeitos", "lista": [{"arquivo": "x.vst3", "ligado": true, "estado": "x.bin"}]}
      {"cmd": "ligado", "i": 0, "ligado": false}  {"cmd": "param", "i": 0, "nome": "key", "valor": "A"}
      {"cmd": "tom", "nota": "A", "modo": "menor"}
      {"cmd": "editor", "i": 0}  {"cmd": "fechar_editor"}  {"cmd": "sair"}
    Respostas na saída padrão, uma por linha: "ETIQUETA {json}"
      PRONTO, ESTADO (posição, nível do microfone…), EFEITOS, TOM, MUSICA, GRAVADO, AVISO, ERRO

A tela do plugin só abre na linha principal do programa (exigência dos plugins), por isso carregar plugins e
abrir a tela vão para uma fila atendida aqui; o resto é atendido direto por quem lê os comandos, e assim tocar,
pausar e mexer nos controles funciona com a tela do plugin aberta.
"""
import argparse
import bisect
import json
import os
import queue
import sys
import threading
import time
from collections import deque

import numpy as np

TAXA = 48000
BLOCO = 256

_fala = threading.Lock()


def dizer(etiqueta, dados):
    with _fala:
        sys.stdout.write(etiqueta + " " + json.dumps(dados) + "\n")
        sys.stdout.flush()


def listar():
    import sounddevice as sd

    aparelhos = sd.query_devices()
    apis = sd.query_hostapis()
    wasapi = [i for i, a in enumerate(apis) if "WASAPI" in a["name"]]
    usar = (lambda d: d["hostapi"] in wasapi) if wasapi else (lambda d: True)
    entradas = [{"id": d["index"], "nome": d["name"]} for d in aparelhos if d["max_input_channels"] > 0 and usar(d)]
    saidas = [{"id": d["index"], "nome": d["name"]} for d in aparelhos if d["max_output_channels"] > 0 and usar(d)]
    padrao = [-1, -1]
    # o padrão do Windows na lista WASAPI (o sd.default aponta para a MME)
    for i in wasapi:
        api = apis[i]
        padrao = [api.get("default_input_device", -1), api.get("default_output_device", -1)]
    dizer("APARELHOS", {"entradas": entradas, "saidas": saidas, "padrao": padrao})


# ---------- controles rápidos ----------
# Parâmetros que aparecem na tela do karaokê, sem abrir o plugin. Só os que o plugin tiver.
RAPIDOS = [
    ("key", "Tom"),
    ("scale", "Escala"),
    ("retune_speed_ms", "Força do Auto-Tune"),
    ("humanize", "Humanizar"),
    ("flex_tune", "Flex-Tune"),
    ("input_type", "Tipo de voz"),
    ("latency_removal", "Baixo atraso"),
    ("mix", "Quantidade de efeito"),
    ("reverbmode", "Tipo de reverb"),
]


def _numero(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def descrever(plugin):
    out = []
    params = plugin.parameters
    reverb = "verb" in (plugin.name or "").lower()
    for nome, rotulo in RAPIDOS:
        if nome not in params:
            continue
        if nome == "mix" and reverb:
            rotulo = "Quantidade de reverb"
        p = params[nome]
        try:
            valores = list(p.valid_values)
            atual = getattr(plugin, nome)
        except Exception:
            continue
        if valores and all(isinstance(v, bool) for v in valores):
            out.append({"nome": nome, "rotulo": rotulo, "tipo": "chave", "valor": bool(atual)})
        elif valores and all(_numero(v) for v in valores):
            fin = [float(v) for v in valores if np.isfinite(v)]
            out.append({"nome": nome, "rotulo": rotulo, "tipo": "numero", "min": min(fin), "max": max(fin),
                        "valor": float(atual)})
        elif valores and len(valores) <= 60:
            out.append({"nome": nome, "rotulo": rotulo, "tipo": "escolha", "valores": [str(v) for v in valores],
                        "valor": str(atual)})
    return out


def por_param(plugin, nome, valor):
    p = plugin.parameters[nome]
    valores = list(p.valid_values)
    if valores and all(isinstance(v, bool) for v in valores):
        valor = bool(valor)
    elif valores and all(_numero(v) for v in valores):
        valor = float(valor)
    else:
        valor = str(valor)
    setattr(plugin, nome, valor)


# nomes das notas como os plugins costumam escrever
SUSTENIDO = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
BEMOL = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def _norm(s):
    return str(s).replace("♯", "#").replace("♭", "b").strip().lower()


def por_tom(plugin, nota, modo):
    """Põe tom e escala num plugin que tenha esses controles. Devolve True se mexeu em algo."""
    params = plugin.parameters
    feito = False
    try:
        n = SUSTENIDO.index(nota) if nota in SUSTENIDO else BEMOL.index(nota)
    except ValueError:
        return False
    nomes = {_norm(SUSTENIDO[n]), _norm(BEMOL[n])}
    for chave in ("key", "root", "root_note", "tonic", "scale_key"):
        if chave not in params:
            continue
        for v in params[chave].valid_values:
            partes = {_norm(x) for x in str(v).split("/")}
            if partes & nomes:
                setattr(plugin, chave, v)
                feito = True
                break
        if feito:
            break
    if "scale" in params:
        quer = "minor" if modo == "menor" else "major"
        for v in params["scale"].valid_values:
            if _norm(v) == quer:
                setattr(plugin, "scale", v)
                feito = True
                break
    return feito


def padroes_iniciais(plugin):
    """Primeira vez que o plugin entra no karaokê (sem ajuste salvo): deixa pronto para cantar ao vivo."""
    params = plugin.parameters
    nome = (plugin.name or "").lower()
    tentativas = []
    if "latency_removal" in params:
        tentativas.append(("latency_removal", True))   # Auto-Tune: modo de baixo atraso, para se ouvir na hora
    if "valhalla" in nome:
        tentativas += [("mix", 20.0), ("reverbmode", "Plate")]   # o padrão dele é 100% de efeito
    for k, v in tentativas:
        try:
            por_param(plugin, k, v)
        except Exception:
            pass


# ---------- nota cantada ----------
def nota_cantada(x48):
    """Nota (MIDI, com fração) de ~64 ms de voz a 48 kHz, pelo método YIN; None se não há voz afinada ali."""
    x = x48[: len(x48) // 3 * 3].reshape(-1, 3).mean(axis=1)   # 16 kHz basta para voz
    x = x - x.mean()
    if float(np.sqrt(np.mean(x * x))) < 0.01:   # silêncio ou quase (~-40 dB)
        return None
    sr, janela = 16000, 512
    maior = min(len(x) - janela - 1, sr // 70)   # até 70 Hz
    menor = sr // 1000                            # até 1000 Hz
    if maior <= menor + 2:
        return None
    from numpy.lib.stride_tricks import sliding_window_view

    q = sliding_window_view(x, janela)[: maior + 1]
    d = ((q[0][None, :] - q) ** 2).sum(axis=1)
    acum = np.cumsum(d[1:])
    dn = np.ones_like(d)
    dn[1:] = d[1:] * np.arange(1, len(d)) / np.maximum(acum, 1e-12)
    abaixo = np.nonzero(dn[menor:] < 0.15)[0]
    if not len(abaixo):
        return None
    t = int(abaixo[0]) + menor
    while t + 1 < len(dn) and dn[t + 1] < dn[t]:
        t += 1
    ajuste = 0.0
    if 0 < t < len(dn) - 1:
        a, b, c = dn[t - 1], dn[t], dn[t + 1]
        den = a - 2 * b + c
        if den:
            ajuste = 0.5 * (a - c) / den
    f = sr / (t + ajuste)
    return float(69 + 12 * np.log2(f / 440.0))


# ---------- áudio ----------
def ler_audio(arquivo):
    import soundfile as sf
    from math import gcd

    from scipy.signal import resample_poly

    dados, taxa = sf.read(arquivo, dtype="float32", always_2d=True)
    if dados.shape[1] == 1:
        dados = np.repeat(dados, 2, axis=1)
    dados = dados[:, :2]
    if taxa != TAXA:
        g = gcd(int(taxa), TAXA)
        dados = resample_poly(dados, TAXA // g, int(taxa) // g, axis=0).astype(np.float32)
    return np.ascontiguousarray(dados)


class Anel:
    """Fila do som já processado da voz, do microfone até o fone. Guarda pouco: sobra vira atraso."""

    def __init__(self):
        self.pedacos = deque()
        self.total = 0
        self.trava = threading.Lock()

    def por(self, x):
        with self.trava:
            self.pedacos.append(x)
            self.total += len(x)
            limite = BLOCO * 3   # folga entre microfone e fone: mais que isso só vira atraso
            while self.total - len(self.pedacos[0]) >= limite and len(self.pedacos) > 1:
                self.total -= len(self.pedacos.popleft())

    def tirar(self, n):
        out = np.zeros((n, 2), np.float32)
        feito = 0
        with self.trava:
            while feito < n and self.pedacos:
                p = self.pedacos[0]
                k = min(n - feito, len(p))
                out[feito:feito + k] = p[:k]
                feito += k
                if k == len(p):
                    self.pedacos.popleft()
                else:
                    self.pedacos[0] = p[k:]
                self.total -= k
        return out

    def limpar(self):
        with self.trava:
            self.pedacos.clear()
            self.total = 0


class Efeito:
    def __init__(self, arquivo, estado, ligado, nome=None):
        from pedalboard import load_plugin

        self.arquivo = arquivo
        self.estado = estado
        self.ligado = bool(ligado)
        self.plugin = load_plugin(arquivo, plugin_name=nome) if nome else load_plugin(arquivo)
        if estado and os.path.exists(estado):
            try:
                with open(estado, "rb") as f:
                    self.plugin.raw_state = f.read()
            except Exception as erro:
                dizer("AVISO", {"mensagem": "não consegui recuperar o ajuste salvo de %s: %s" % (self.plugin.name, erro)})
        else:
            padroes_iniciais(self.plugin)
        # aplica o ajuste já: o atraso que o plugin informa (e que o pedalboard desconta) só muda depois
        # de um reset; sem isto o Auto-Tune em "Baixo atraso" ainda aparecia com 56 ms (na verdade, 2,5 ms)
        try:
            self.plugin.reset()
        except Exception:
            pass

    def salvar(self):
        if not self.estado:
            return
        try:
            os.makedirs(os.path.dirname(self.estado), exist_ok=True)
            with open(self.estado, "wb") as f:
                f.write(self.plugin.raw_state)
        except Exception as erro:
            dizer("AVISO", {"mensagem": "não consegui salvar o ajuste de %s: %s" % (self.plugin.name, erro)})

    def latencia(self):
        try:
            return int(self.plugin.reported_latency_samples or 0)
        except Exception:
            return 0


class Gravacao:
    def __init__(self, pasta, nome, n, nomes_efeitos):
        self.pasta = pasta
        self.nome = nome
        self.crua = np.zeros(n, np.float32)
        self.final = np.zeros((n, 2), np.float32)
        # com mais de um efeito, guarda também a voz só com o primeiro (o Auto-Tune, sem o reverb)
        self.primeiro = np.zeros((n, 2), np.float32) if len(nomes_efeitos) > 1 else None
        self.nome_primeiro = nomes_efeitos[0] if nomes_efeitos else ""
        self.usado = 0   # até onde a música andou gravando

    def escrever(self, alvo, pos, dados):
        if pos is None:
            return
        n = len(alvo)
        ini = max(0, pos)
        fim = min(n, pos + len(dados))
        if fim <= ini:
            return
        alvo[ini:fim] = dados[ini - pos:fim - pos]
        self.usado = max(self.usado, fim)


def _livre(caminho):
    base, ext = os.path.splitext(caminho)
    n = 2
    while os.path.exists(caminho):
        caminho = "%s %d%s" % (base, n, ext)
        n += 1
    return caminho


def _limpo(s):
    for c in '\\/:*?"<>|':
        s = s.replace(c, " ")
    return " ".join(s.split()).strip(" .") or "karaoke"


class Karaoke:
    def __init__(self):
        self.tarefas = queue.Queue()   # o que precisa rodar na linha principal
        self.inst = None
        self.guia = None
        self.n = 0
        self.cursor = 0
        self.tocando = False
        self.acabou = False
        self.vol_inst = 1.0
        self.vol_voz = 1.0
        self.vol_guia = 0.0
        self.me_ouvir = True
        self.ref = (0.0, 0, False)   # (hora do som na saída, posição da música nessa hora, tocando)
        self.anel = Anel()
        self.efeitos = []
        self.corrente = ()
        self.reiniciar = True
        self.prod = []
        self.atraso = []
        self.pendente = []
        self.medir_atraso = []
        self.entrada_total = 0
        self.mapa_ini = []
        self.mapa_pos = []
        self.nivel = 0.0
        self.grav = None
        self.ent = None
        self.sai = None
        self.lat_ent = 0.01
        self.lat_sai = 0.01
        self.exclusivo = False   # fone aberto em modo exclusivo (menos atraso)
        self.editor_aberto = -1
        self.pausa = False      # plugins sem processar (tela de plugin aberta)
        self.pausa_ok = True
        self.sujos = set()       # plugins mexidos pelos controles do app, ainda sem salvar
        self.sujo_em = 0.0
        self.cru = (np.zeros(4096, np.float32), 0)   # voz crua mais recente e o índice da última amostra
        self.saindo = False

    # ----- aparelhos -----
    def abrir(self, entrada, saida, exclusivo=False):
        import sounddevice as sd

        self.fechar()
        self.anel.limpar()

        def extra(dev):
            api = sd.query_hostapis(sd.query_devices(dev)["hostapi"])["name"]
            return sd.WasapiSettings(exclusive=False, auto_convert=True) if "WASAPI" in api else None

        # Medido no PC dele: no modo compartilhado do Windows todo aparelho fica em 22 ms, peça-se o que for.
        # O fone em modo exclusivo com bloco de 128 cai para ~11 ms (o microfone USB não melhora: fica no
        # compartilhado, e assim Voicemod e Discord continuam podendo usá-lo).
        self.exclusivo = False
        if saida is None or saida < 0:
            saida = sd.default.device[1]
        info = sd.query_devices(saida)
        canais = max(1, min(2, int(info["max_output_channels"])))
        api_saida = sd.query_hostapis(info["hostapi"])["name"]
        tentativas = []
        if exclusivo and "WASAPI" in api_saida:
            tentativas += [dict(blocksize=128, latency=0.003, channels=c, extra_settings=sd.WasapiSettings(exclusive=True))
                           for c in sorted({canais, 2, 1}, reverse=True)]
        tentativas.append(dict(blocksize=BLOCO, latency="low", channels=canais, extra_settings=extra(saida)))
        for n, t in enumerate(tentativas):
            try:
                self.sai = sd.OutputStream(device=saida, samplerate=TAXA, dtype="float32", callback=self._saida, **t)
                self.sai.start()
                self.exclusivo = isinstance(t["latency"], float)
                break
            except Exception as erro:
                self.sai = None
                if n == len(tentativas) - 1:
                    raise
                if n == len(tentativas) - 2 and exclusivo:
                    dizer("AVISO", {"mensagem": "o fone não aceitou o modo exclusivo; ficou no normal (%s)" % str(erro).split("\n")[0][:80]})
        self.lat_sai = float(self.sai.latency or 0.01)
        if entrada is not None and entrada >= 0:
            info = sd.query_devices(entrada)
            # bloco 0: entrega o som do microfone assim que o Windows entrega, sem esperar juntar um bloco nosso
            self.ent = sd.InputStream(device=entrada, samplerate=TAXA, blocksize=0, dtype="float32", latency="low",
                                      channels=max(1, min(2, int(info["max_input_channels"]))),
                                      callback=self._entrada, extra_settings=extra(entrada))
            self.ent.start()
            self.lat_ent = float(self.ent.latency or 0.01)

    def fechar(self):
        for s in (self.ent, self.sai):
            if s is not None:
                try:
                    s.stop()
                    s.close()
                except Exception:
                    pass
        self.ent = self.sai = None

    # ----- som que sai: instrumental + voz -----
    def _saida(self, outdata, frames, tempo, status):
        mix = np.zeros((frames, 2), np.float32)
        hora = tempo.outputBufferDacTime or (tempo.currentTime + self.lat_sai)
        inst = self.inst
        if self.tocando and inst is not None:
            i = self.cursor
            f = min(i + frames, self.n)
            k = f - i
            if k > 0:
                mix[:k] += inst[i:f] * self.vol_inst
                if self.guia is not None and self.vol_guia > 0:
                    g = self.guia
                    kg = max(0, min(f, len(g)) - i)
                    if kg:
                        mix[:kg] += g[i:i + kg] * self.vol_guia
            self.ref = (hora, i, True)
            self.cursor = f
            if f >= self.n:
                self.tocando = False
                self.acabou = True
        else:
            self.ref = (hora, self.cursor, False)
        voz = self.anel.tirar(frames)
        if self.me_ouvir:
            mix += voz * self.vol_voz
        np.clip(mix, -1.0, 1.0, out=mix)
        if outdata.shape[1] == 1:
            outdata[:, 0] = mix.mean(axis=1)
        else:
            outdata[:, :2] = mix
            if outdata.shape[1] > 2:
                outdata[:, 2:] = 0

    # posição da música (em amostras) que corresponde a uma amostra de entrada; None se a música estava parada
    def _pos_de(self, idx):
        j = bisect.bisect_right(self.mapa_ini, idx) - 1
        if j < 0:
            return None
        p = self.mapa_pos[j]
        return None if p is None else p + (idx - self.mapa_ini[j])

    # ----- som que entra: microfone -> plugins -----
    def _entrada(self, indata, frames, tempo, status):
        if indata.shape[1] > 1:
            energia = (indata * indata).sum(axis=0)
            # microfone de um canal só em aparelho estéreo: fica com o canal que tem som
            mono = indata[:, int(np.argmax(energia))] if energia.min() < 0.01 * energia.max() else indata.mean(axis=1)
        else:
            mono = indata[:, 0]
        mono = np.ascontiguousarray(mono, dtype=np.float32)
        pico = float(np.abs(mono).max()) if frames else 0.0
        self.nivel = max(self.nivel * 0.85, pico)

        hora = tempo.inputBufferAdcTime or (tempo.currentTime - self.lat_ent)
        h_ref, pos_ref, tocava = self.ref
        pos = pos_ref + int(round((hora - h_ref) * TAXA)) if tocava else None
        idx = self.entrada_total
        self.mapa_ini.append(idx)
        self.mapa_pos.append(pos)
        if len(self.mapa_ini) > 4000:
            del self.mapa_ini[:2000]
            del self.mapa_pos[:2000]
        self.entrada_total += frames
        # últimos ~85 ms da voz crua (antes dos plugins), para medir a nota cantada
        anterior = self.cru[0]
        n_cru = len(anterior)
        self.cru = (np.concatenate((anterior[frames:], mono)) if frames < n_cru else mono[-n_cru:].copy(), self.entrada_total)

        grav = self.grav
        if grav is not None and pos is not None:
            grav.escrever(grav.crua, pos, mono)

        if self.pausa:
            # tela de plugin aberta: nenhum plugin pode processar som (o pedalboard derruba o processo);
            # a voz passa sem efeito até a tela fechar
            self.pausa_ok = True
            self.reiniciar = True
            corrente = ()
        else:
            corrente = self.corrente
        if self.reiniciar or len(self.prod) != len(corrente):
            self.reiniciar = False
            for ef in corrente:
                try:
                    ef.plugin.reset()
                except Exception:
                    pass
            self.prod = [idx] * len(corrente)
            self.atraso = [0] * len(corrente)
            self.pendente = [None] * len(corrente)
            self.medir_atraso = [True] * len(corrente)

        y = np.stack([mono, mono])
        for s, ef in enumerate(corrente):
            if self.pendente[s] is not None:
                y = np.concatenate([self.pendente[s], y], axis=1)
                self.pendente[s] = None
            if y.shape[1] < 32:   # pedaço curto demais confunde o plugin (canais x amostras): junta com o próximo
                self.pendente[s] = y
                y = None
                break
            n_entrou = y.shape[1]
            try:
                y = ef.plugin.process(y, TAXA, buffer_size=max(BLOCO, n_entrou), reset=False)
            except Exception as erro:
                dizer("AVISO", {"mensagem": "%s falhou e foi desligado: %s" % (ef.plugin.name, erro)})
                ef.ligado = False
                self.corrente = tuple(e for e in self.efeitos if e.ligado)
                self.reiniciar = True
                return
            if y.ndim == 1:
                y = np.stack([y, y])
            if y.shape[0] == 1:
                y = np.repeat(y, 2, axis=0)
            y = y[:2]
            if self.medir_atraso[s]:
                # o pedalboard costuma devolver menos amostras no começo, já descontando o atraso do plugin;
                # se devolveu tudo de uma vez, o atraso está dentro do som e é descontado aqui na gravação
                self.medir_atraso[s] = False
                if y.shape[1] >= n_entrou:
                    self.atraso[s] = ef.latencia()
            m = y.shape[1]
            if grav is not None and grav.primeiro is not None and s == 0 and m:
                grav.escrever(grav.primeiro, self._pos_de(self.prod[s] - self.atraso[s]), y.T)
            if grav is not None and s == len(corrente) - 1 and m:
                grav.escrever(grav.final, self._pos_de(self.prod[s] - sum(self.atraso)), y.T)
            self.prod[s] += m
            if m == 0:
                y = None
                break
        if y is None:
            return
        if not corrente and grav is not None:
            grav.escrever(grav.final, pos, y.T)
        self.anel.por(np.ascontiguousarray(y.T, dtype=np.float32))

    # ----- efeitos (linha principal) -----
    def carregar_efeitos(self, lista):
        for ef in self.efeitos:
            ef.salvar()
        novos = []
        relato = []
        for i, item in enumerate(lista):
            try:
                ef = Efeito(item["arquivo"], item.get("estado"), item.get("ligado", True), item.get("nome"))
                novos.append(ef)
                relato.append(None)
            except Exception as erro:
                novos.append(None)
                relato.append(str(erro).split("\n")[0])
        self.efeitos = [e for e in novos if e is not None]
        self.corrente = tuple(e for e in self.efeitos if e.ligado)
        self.reiniciar = True
        self.relatar(lista, relato)

    def relatar(self, lista=None, erros=None):
        out = []
        if lista is not None:
            vivos = iter(self.efeitos)
            for item, erro in zip(lista, erros):
                if erro:
                    out.append({"arquivo": item["arquivo"], "ok": False, "erro": erro})
                    continue
                out.append(self._ficha(next(vivos)))
        else:
            out = [self._ficha(e) for e in self.efeitos]
        dizer("EFEITOS", {"lista": out})

    def _ficha(self, ef):
        try:
            rapidos = descrever(ef.plugin)
        except Exception:
            rapidos = []
        return {"arquivo": ef.arquivo, "ok": True, "nome": ef.plugin.name, "ligado": ef.ligado,
                "latencia_ms": round(ef.latencia() * 1000 / TAXA), "rapidos": rapidos}

    def editor(self, i):
        if not (0 <= i < len(self.efeitos)) or self.editor_aberto >= 0:
            return
        ef = self.efeitos[i]
        # põe os plugins em pausa e espera o som confirmar (um bloco inteiro já sem plugin) antes de abrir
        self.pausa_ok = self.ent is None
        self.pausa = True
        limite = time.time() + 1.0
        while not self.pausa_ok and time.time() < limite:
            time.sleep(0.005)
        time.sleep(0.02)
        self.editor_aberto = i
        dizer("EDITOR", {"aberto": True, "i": i})
        try:
            # sem close_event: com ele o pedalboard derruba o processo ao abrir a tela (testado em 0.9.16 a 0.9.26)
            ef.plugin.show_editor()
        except Exception as erro:
            dizer("AVISO", {"mensagem": "a tela do %s não abriu: %s" % (ef.plugin.name, erro)})
        finally:
            self.editor_aberto = -1
            self.pausa = False
            dizer("EDITOR", {"aberto": False, "i": i})
        ef.salvar()
        self.reiniciar = True   # o atraso do plugin pode ter mudado (ex.: modo de baixo atraso)
        self.relatar()

    # ----- gravação -----
    def salvar_gravacao(self):
        g = self.grav
        self.grav = None
        if g is None:
            return
        if g.usado == 0:
            dizer("GRAVADO", {"arquivos": [], "aviso": "nada foi gravado"})
            return
        import soundfile as sf

        n = self.n or g.usado
        base = _limpo(g.nome)
        feitos = []
        trilhas = [("(minha voz)", g.final), ("(minha voz crua)", g.crua)]
        if g.primeiro is not None:
            trilhas.insert(1, ("(minha voz só %s)" % _limpo(g.nome_primeiro), g.primeiro))
        for rotulo, dados in trilhas:
            arq = _livre(os.path.join(g.pasta, "%s %s.wav" % (base, rotulo)))
            sf.write(arq, dados[:n], TAXA, subtype="PCM_24")
            feitos.append(arq)
        dizer("GRAVADO", {"arquivos": feitos})

    # ----- comandos -----
    def comando(self, c):
        cmd = c.get("cmd")
        if cmd == "aparelhos":
            tocava = self.tocando
            self.tocando = False
            try:
                self.abrir(c.get("entrada"), c.get("saida"), bool(c.get("exclusivo")))
                lat = round((self.lat_ent + self.lat_sai) * 1000)
                dizer("APARELHOS_OK", {"latencia_ms": lat, "exclusivo": self.exclusivo})
            except Exception as erro:
                dizer("ERRO", {"mensagem": "não consegui abrir o som: %s" % erro})
            self.tocando = tocava
        elif cmd == "musica":
            self.tocando = False
            if self.grav is not None:
                self.salvar_gravacao()
            try:
                inst = ler_audio(c["instrumental"])
                guia = ler_audio(c["guia"]) if c.get("guia") and os.path.exists(c["guia"]) else None
            except Exception as erro:
                dizer("ERRO", {"mensagem": "não consegui ler a música: %s" % erro})
                return
            self.guia = None
            self.inst = inst
            self.n = len(inst)
            self.guia = guia
            # troca de tom: a música nova continua do mesmo ponto
            self.cursor = int(max(0, min(self.n, float(c.get("pos") or 0) * TAXA)))
            self.acabou = False
            dizer("MUSICA", {"duracao": self.n / TAXA})
            if c.get("tocar"):
                self.tocando = True
        elif cmd == "tocar":
            if self.inst is not None:
                if self.cursor >= self.n:
                    self.cursor = 0
                self.acabou = False
                self.tocando = True
        elif cmd == "pausar":
            self.tocando = False
        elif cmd == "ir":
            self.cursor = int(max(0, min(self.n, float(c.get("s", 0)) * TAXA)))
        elif cmd == "volumes":
            self.vol_inst = float(c.get("instrumental", self.vol_inst))
            self.vol_voz = float(c.get("voz", self.vol_voz))
            self.vol_guia = float(c.get("guia", self.vol_guia))
        elif cmd == "ouvir":
            self.me_ouvir = bool(c.get("ligado"))
        elif cmd == "gravar":
            if self.inst is None:
                return dizer("AVISO", {"mensagem": "escolha uma música antes de gravar"})
            if self.ent is None:
                return dizer("AVISO", {"mensagem": "escolha o microfone antes de gravar"})
            nomes = [e.plugin.name for e in self.corrente]
            self.grav = Gravacao(c["pasta"], c.get("nome") or "karaoke", self.n + TAXA, nomes)
            self.acabou = False
            self.tocando = True
        elif cmd == "parar_gravacao":
            self.tocando = False
            self.salvar_gravacao()
        elif cmd == "efeitos":
            self.tarefas.put(lambda: self.carregar_efeitos(c.get("lista") or []))
        elif cmd == "ligado":
            i = int(c.get("i", -1))
            if 0 <= i < len(self.efeitos):
                self.efeitos[i].ligado = bool(c.get("ligado"))
                self.corrente = tuple(e for e in self.efeitos if e.ligado)
                self.reiniciar = True
        elif cmd == "param":
            i = int(c.get("i", -1))
            if self.editor_aberto >= 0:
                return dizer("AVISO", {"mensagem": "feche a tela do plugin antes de mexer nos controles"})
            if 0 <= i < len(self.efeitos):
                try:
                    por_param(self.efeitos[i].plugin, c["nome"], c["valor"])
                    self.sujos.add(self.efeitos[i])
                    self.sujo_em = time.time()
                    if c["nome"] == "latency_removal":
                        self.reiniciar = True
                except Exception as erro:
                    dizer("AVISO", {"mensagem": "não consegui mudar %s: %s" % (c.get("nome"), erro)})
        elif cmd == "tom":
            if self.editor_aberto >= 0:
                return
            mexeu = []
            for ef in self.efeitos:
                try:
                    if por_tom(ef.plugin, c.get("nota"), c.get("modo")):
                        mexeu.append(ef.plugin.name)
                except Exception:
                    pass
            dizer("TOM", {"plugins": mexeu, "nota": c.get("nota"), "modo": c.get("modo")})
            if mexeu:
                self.relatar()
        elif cmd == "editor":
            self.tarefas.put(lambda: self.editor(int(c.get("i", -1))))
        elif cmd == "sair":
            self.sair()

    def sair(self):
        if self.saindo:
            return
        self.saindo = True
        self.tocando = False
        if self.editor_aberto >= 0:
            # a tela do plugin prende a linha principal e não dá para fechá-la por fora: salva daqui e encerra
            try:
                self.salvar_gravacao()
            except Exception:
                pass
            for ef in self.efeitos:
                ef.salvar()
            sys.stdout.flush()
            os._exit(0)
        self.tarefas.put(None)

    def ler_comandos(self):
        for linha in sys.stdin:
            linha = linha.strip()
            if not linha:
                continue
            try:
                c = json.loads(linha)
            except ValueError:
                continue
            try:
                self.comando(c)
            except Exception as erro:
                dizer("ERRO", {"mensagem": str(erro)})
        self.sair()   # entrada fechou: o app sumiu

    def relogio(self):
        while not self.saindo:
            time.sleep(0.05)
            if self.acabou and self.grav is not None:
                self.acabou = False
                try:
                    self.salvar_gravacao()
                except Exception as erro:
                    dizer("ERRO", {"mensagem": "não consegui salvar a gravação: %s" % erro})
            # ajuste mexido pelos controles do app: salva um segundo depois da última mudança
            if self.sujos and self.editor_aberto < 0 and time.time() - self.sujo_em > 1.0:
                sujos, self.sujos = self.sujos, set()
                for ef in sujos:
                    ef.salvar()
            # nota que a pessoa está cantando e o ponto da música em que ela cantou
            voz = voz_pos = None
            if self.ent is not None and self.tocando:
                cru, fim = self.cru
                try:
                    voz = nota_cantada(cru[-3072:])
                    p = self._pos_de(fim - 1536)
                    voz_pos = None if p is None else round(p / TAXA, 3)
                except Exception:
                    voz = None
            # posição que a pessoa está ouvindo agora (o som ainda vai sair pelo fone)
            pos = max(0.0, self.cursor / TAXA - (self.lat_sai if self.tocando else 0))
            lat_plug = sum(e.latencia() for e in self.corrente)
            dizer("ESTADO", {
                "pos": round(pos, 3), "tocando": self.tocando, "gravando": self.grav is not None,
                "nivel": round(self.nivel, 3), "duracao": round(self.n / TAXA, 2), "fim": self.acabou,
                "latencia_ms": round((self.lat_ent + self.lat_sai) * 1000 + lat_plug * 1000 / TAXA + self.anel.total * 1000 / TAXA),
                "lat_som": round((self.lat_ent + self.lat_sai) * 1000), "lat_plugins": round(lat_plug * 1000 / TAXA),
                "lat_fila": round(self.anel.total * 1000 / TAXA),
                "microfone": self.ent is not None, "pausa": self.pausa,
                "voz": None if voz is None else round(voz, 2), "voz_pos": voz_pos if voz is not None else None,
            })

    def rodar(self):
        threading.Thread(target=self.ler_comandos, daemon=True).start()
        threading.Thread(target=self.relogio, daemon=True).start()
        dizer("PRONTO", {"taxa": TAXA})
        while True:
            tarefa = self.tarefas.get()
            if tarefa is None:
                break
            try:
                tarefa()
            except Exception as erro:
                dizer("ERRO", {"mensagem": str(erro).split("\n")[0]})
        # saindo: guarda o que estava gravando e o ajuste dos plugins
        try:
            if self.grav is not None:
                self.salvar_gravacao()
        finally:
            self.fechar()
            for ef in self.efeitos:
                ef.salvar()


def main():
    # o app roda com -I, que ignora PYTHONUTF8: sem isto, acento (pasta "… karaokê", "correção") chega quebrado
    for canal in (sys.stdin, sys.stdout, sys.stderr):
        try:
            canal.reconfigure(encoding="utf-8")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--listar", action="store_true")
    a = ap.parse_args()
    if a.listar:
        return listar()
    Karaoke().rodar()
    sys.stdout.flush()
    os._exit(0)   # threads presas em plugins não seguram o fim


if __name__ == "__main__":
    main()
