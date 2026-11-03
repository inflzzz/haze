"""Voz ao vivo: o microfone entra, sai a voz do modelo. Usa o motor de tempo real do Applio, sem a tela dele.

Roda com o Python do Applio e com a pasta do Applio como pasta de trabalho. Nada dentro do Applio é alterado.

Listar os aparelhos de som:
    python aovivo.py --listar
    -> uma linha "APARELHOS {json}" com {"entradas": [{"id", "nome"}], "saidas": [...]}

Ligar:
    python aovivo.py --modelo voz.pth --indice voz.index --entrada 3 --saida 7 --tom 0 ...
    -> linha "TESTE {json}" quando uma gravação de teste pedida pelo controle fica pronta
    -> linhas "ESTADO {json}" a cada 0,3 s: {"latencia": ms, "volume": 0 a 1, "ouvindo": bool, "pronto": bool, "aquecendo": blocos}
    Comandos pelo arquivo de --controle (JSON, relido quando muda): {"tom": -12, "retorno": true, "parar": false,
    "testar": {"id": 1, "arquivo": "teste.wav", "segundos": 8},
    "modelo": {"id": 1, "pth": "outra.pth", "indice": "outra.index"}}  ("modelo" troca a voz sem desligar).
    --retorno N abre um segundo aparelho de saída só para a pessoa se ouvir; "retorno" no controle liga e
    desliga esse som na hora. (O monitor do próprio Applio não serve aqui: com microfone e saída em aparelhos
    diferentes ele disputa a mesma fila com a saída principal e os dois picotam.)
    Se o processo de --pai (o app) sumir, desliga sozinho.

    Por que arquivo e não a entrada padrão: no Windows, se este processo fica parado lendo a entrada padrão,
    o processo filho do motor (que herda o mesmo canal) trava ao nascer e nunca carrega o modelo.
"""
import argparse
import json
import os
import sys
import time


def dizer(etiqueta, dados):
    sys.stdout.write(etiqueta + " " + json.dumps(dados) + "\n")
    sys.stdout.flush()


def listar():
    import sounddevice as sd

    aparelhos = sd.query_devices()
    apis = sd.query_hostapis()
    # o Windows mostra cada aparelho uma vez por tecnologia (MME, DirectSound, WASAPI…); fica só a WASAPI,
    # que é a que o Applio usa em modo compartilhado e traz o nome inteiro do aparelho
    wasapi = [i for i, a in enumerate(apis) if "WASAPI" in a["name"]]
    usar = (lambda d: d["hostapi"] in wasapi) if wasapi else (lambda d: True)
    entradas = [{"id": d["index"], "nome": d["name"]} for d in aparelhos if d["max_input_channels"] > 0 and usar(d)]
    saidas = [{"id": d["index"], "nome": d["name"]} for d in aparelhos if d["max_output_channels"] > 0 and usar(d)]
    padrao = sd.default.device
    dizer("APARELHOS", {"entradas": entradas, "saidas": saidas, "padrao": [padrao[0], padrao[1]]})


def limpar_orfaos():
    """Encerra motores ao vivo que ficaram para trás: processos-filho deste Python cujo pai não existe mais."""
    try:
        import psutil
    except ImportError:
        return
    eu = os.path.normcase(sys.executable)
    for p in psutil.process_iter(["pid", "ppid", "exe", "cmdline"]):
        try:
            linha = " ".join(p.info["cmdline"] or [])
            if "--multiprocessing-fork" not in linha or os.path.normcase(p.info["exe"] or "") != eu:
                continue
            if not psutil.pid_exists(p.info["ppid"]):
                p.kill()
        except (psutil.Error, OSError):
            pass


def ligar(a):
    limpar_orfaos()
    sys.path.insert(0, os.getcwd())
    from rvc.realtime.audio import resolve_sample_rate
    from rvc.realtime.callbacks import AudioCallbacks

    taxa = resolve_sample_rate(a.entrada, False, 48000)
    bloco = max(1, int(a.bloco * taxa / 1000 / 128))

    # mesmos nomes e padrões que a aba de tempo real do Applio passa; os efeitos ficam desligados
    efeitos = {
        "reverb": False, "pitch_shift": False, "limiter": False, "gain": False, "distortion": False,
        "chorus": False, "bitcrush": False, "clipping": False, "compressor": False, "delay": False,
        "reverb_room_size": 0.5, "reverb_damping": 0.5, "reverb_wet_level": 0.5, "reverb_dry_level": 0.5,
        "reverb_width": 0.5, "reverb_freeze_mode": 0.5, "pitch_shift_semitones": 0.0,
        "limiter_threshold": -6, "limiter_release": 0.01, "gain_db": 0.0, "distortion_gain": 25,
        "chorus_rate": 1.0, "chorus_depth": 0.25, "chorus_delay": 7, "chorus_feedback": 0.0, "chorus_mix": 0.5,
        "bitcrush_bit_depth": 8, "clipping_threshold": -6, "compressor_threshold": 0, "compressor_ratio": 1,
        "compressor_attack": 1.0, "compressor_release": 100, "delay_seconds": 0.5, "delay_feedback": 0.0,
        "delay_mix": 0.5,
    }
    motor = AudioCallbacks(
        pass_through=False,
        read_chunk_size=bloco,
        cross_fade_overlap_size=a.emenda,
        extra_convert_size=a.contexto,
        model_path=a.modelo,
        index_path=str(a.indice or ""),
        f0_method=a.f0,
        embedder_model=a.embedder,
        embedder_model_custom=None,
        silent_threshold=a.portao,
        f0_up_key=a.tom,
        index_rate=a.index_rate,
        protect=a.protect,
        volume_envelope=1,
        f0_autotune=False,
        f0_autotune_strength=1,
        proposed_pitch=False,
        proposed_pitch_threshold=155.0,
        input_audio_gain=1.0,
        output_audio_gain=1.0,
        monitor_audio_gain=1.0,
        monitor=False,
        vad_enabled=False,
        vad_sensitivity=3,
        vad_frame_ms=30,
        sid=0,
        clean_audio=False,
        clean_strength=0.5,
        post_process=False,
        record_audio=False,
        record_audio_path=None,
        export_format="WAV",
        audio_sample_rate=taxa,
        kwargs=efeitos,
    )
    som = motor.audio
    ultima = [0.0]
    modelo_em_uso = [0]   # id do último pedido de troca de modelo atendido

    import numpy as np

    # Cada bloco convertido passa por aqui antes de ir para a saída. Serve a duas coisas:
    #   retorno  cópia para uma fila própria, tocada num segundo aparelho
    #   teste    cópia guardada por alguns segundos e gravada em arquivo, para a pessoa se ouvir depois
    retorno = {"ligado": bool(a.retorno_ligado), "fila": None, "saida": None}
    teste = {"id": 0, "faltam": 0, "blocos": [], "arquivo": ""}
    converter = som.process_data_with_time

    def converter_e_copiar(indata):
        bloco_convertido = converter(indata)
        if retorno["ligado"] and retorno["fila"] is not None:
            retorno["fila"].put(bloco_convertido)
        if teste["faltam"] > 0:
            teste["blocos"].append(np.array(bloco_convertido, dtype=np.float32, copy=True))
            teste["faltam"] -= len(bloco_convertido)
        return bloco_convertido

    som.process_data_with_time = converter_e_copiar

    if a.retorno >= 0 and a.retorno != a.saida:
        import sounddevice as sd
        from queue import Empty, Queue

        retorno["fila"] = Queue()

        aparelho = sd.query_devices(a.retorno)
        canais = max(1, min(2, int(aparelho["max_output_channels"])))
        api = sd.query_hostapis(aparelho["hostapi"])["name"]

        def tocar_retorno(outdata, frames, tempo, status):
            outdata[:] = 0
            if not retorno["ligado"]:
                while not retorno["fila"].empty():   # desligado: não acumula som velho
                    retorno["fila"].get_nowait()
                return
            try:
                som_do_bloco = retorno["fila"].get(timeout=1.0)
                while not retorno["fila"].empty():   # fica sempre com o bloco mais novo
                    som_do_bloco = retorno["fila"].get_nowait()
            except Empty:
                return
            n = min(len(som_do_bloco), frames)
            outdata[:n] = np.repeat(som_do_bloco[:n], canais).reshape(-1, canais)

        retorno["saida"] = sd.OutputStream(
            callback=tocar_retorno, latency="low", dtype=np.float32, device=a.retorno, blocksize=bloco * 128,
            samplerate=taxa, channels=canais,
            extra_settings=sd.WasapiSettings(exclusive=False, auto_convert=True) if "WASAPI" in api else None,
        )

    def comandos():
        """Lê o arquivo de controle se ele mudou. Devolve True quando é para desligar."""
        if a.pai:
            try:
                import psutil
                if not psutil.pid_exists(a.pai):
                    return True
            except ImportError:
                pass
        if not a.controle:
            return False
        try:
            mudou = os.path.getmtime(a.controle)
            if mudou == ultima[0]:
                return False
            ultima[0] = mudou
            with open(a.controle, "r", encoding="utf-8") as f:
                c = json.load(f)
        except (OSError, ValueError):
            return False
        if "retorno" in c:
            retorno["ligado"] = bool(c["retorno"])
        if "tom" in c:
            som.f0_up_key = max(-24, min(24, int(c["tom"])))
        outro = c.get("modelo")
        if outro and outro.get("id") != modelo_em_uso[0] and outro.get("pth"):
            # o motor do Applio troca a voz e o índice sem fechar o microfone nem a saída
            modelo_em_uso[0] = outro["id"]
            motor.vc.send_config({"model_path": outro["pth"], "index_path": outro.get("indice") or ""})
        pedido = c.get("testar")
        if pedido and pedido.get("id") != teste["id"] and pedido.get("arquivo"):
            teste["id"] = pedido["id"]
            teste["arquivo"] = pedido["arquivo"]
            teste["blocos"] = []
            teste["faltam"] = int(float(pedido.get("segundos", 8)) * taxa)
        return bool(c.get("parar"))

    try:
        som.start(
            input_device_id=a.entrada,
            output_device_id=a.saida,
            output_monitor_id=None,
            exclusive_mode=False,
            asio_input_channel=-1,
            asio_output_channel=-1,
            asio_output_monitor_channel=-1,
            read_chunk_size=bloco,
            audio_sample_rate=taxa,
            asio_output_stereo=True,
        )
        if retorno["saida"] is not None:
            retorno["saida"].start()
        dizer("ESTADO", {"ligado": True, "taxa": taxa})
        while not comandos():
            time.sleep(0.3)
            if teste["arquivo"] and teste["faltam"] <= 0 and teste["blocos"]:
                import soundfile as sf

                gravado = np.concatenate(teste["blocos"])
                sf.write(teste["arquivo"], gravado, taxa, subtype="PCM_16")
                # toca aqui mesmo, no aparelho do retorno (o fone da pessoa): o som do app iria para a saída
                # padrão do Windows, que pode ser outro aparelho (monitor, cabo virtual)
                tocando = False
                if a.retorno >= 0:
                    try:
                        import sounddevice as sd

                        nome_api = sd.query_hostapis(sd.query_devices(a.retorno)["hostapi"])["name"]
                        sd.play(gravado, taxa, device=a.retorno,
                                extra_settings=sd.WasapiSettings(exclusive=False, auto_convert=True) if "WASAPI" in nome_api else None)
                        tocando = True
                    except Exception as erro:
                        print("nao deu para tocar o teste no aparelho do retorno:", erro, flush=True)
                dizer("TESTE", {"id": teste["id"], "arquivo": teste["arquivo"], "tocando": tocando,
                                "segundos": round(len(gravado) / taxa, 1)})
                teste["blocos"] = []
                teste["arquivo"] = ""
            modelo = getattr(motor.vc, "vc_model", None)
            processo = getattr(motor.vc, "_process", None)
            if processo is not None and not processo.is_alive():
                # sai na hora, sem a arrumação normal: com o motor morto, fechar os aparelhos de som pode
                # ficar esperando para sempre, e o app precisa saber logo que caiu
                dizer("ERRO", {"mensagem": "o motor de conversao fechou sozinho (codigo %s)" % processo.exitcode})
                os._exit(1)
            dizer("ESTADO", {
                "latencia": round(float(getattr(som, "latency", 0) or 0), 1),
                "volume": round(float(getattr(som, "volume", 0) or 0), 5),   # volume de entrada, de 0 a 1
                "ouvindo": hasattr(som, "latency"),
                "pronto": getattr(motor, "_last_output", None) is not None,   # o motor já devolveu som
                "aquecendo": int(getattr(modelo, "warmup_blocks", 0) or 0),
            })
    finally:
        try:
            if retorno["saida"] is not None:
                retorno["saida"].close()
            som.stop()
        finally:
            motor.vc.stop()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listar", action="store_true")
    ap.add_argument("--modelo")
    ap.add_argument("--indice", default="")
    ap.add_argument("--entrada", type=int)
    ap.add_argument("--saida", type=int)
    ap.add_argument("--tom", type=int, default=0)
    ap.add_argument("--f0", default="rmvpe")
    ap.add_argument("--embedder", default="contentvec")
    ap.add_argument("--index-rate", dest="index_rate", type=float, default=0.75)
    ap.add_argument("--protect", type=float, default=0.33)
    ap.add_argument("--bloco", type=float, default=250.0, help="tamanho do bloco de som, em ms")
    ap.add_argument("--emenda", type=float, default=0.05, help="transição entre um bloco e o seguinte, em s (0.05 a 0.2)")
    ap.add_argument("--contexto", type=float, default=2.5, help="quanto de som anterior o motor relê a cada bloco, em s (0.1 a 5)")
    ap.add_argument("--portao", type=int, default=-60, help="abaixo deste volume (dB) o som é tratado como silêncio")
    ap.add_argument("--retorno", type=int, default=-1, help="aparelho de saída para a pessoa se ouvir")
    ap.add_argument("--retorno-ligado", dest="retorno_ligado", type=int, default=0)
    ap.add_argument("--controle", default="", help="arquivo JSON com os comandos")
    ap.add_argument("--pai", type=int, default=0, help="PID do app; se sumir, desliga")
    a = ap.parse_args()
    if a.listar:
        return listar()
    try:
        ligar(a)
    except Exception as erro:  # o app mostra a mensagem; o resto do rastro fica no registro
        import traceback

        traceback.print_exc()
        dizer("ERRO", {"mensagem": str(erro)})
        sys.exit(1)


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    main()
